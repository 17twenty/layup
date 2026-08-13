package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

const (
	// DefaultHeartbeatInterval is how often the server proves it is alive.
	DefaultHeartbeatInterval = 5 * time.Second
	// DefaultSendQueue bounds per-connection buffering. Beyond this the client
	// is disconnected instead of accumulating stale state.
	DefaultSendQueue = 64
	// maxMessageBytes caps an inbound message. Control-plane messages are small.
	maxMessageBytes = 64 * 1024
)

// Conn is one client's realtime connection.
type Conn struct {
	id       string
	user     domain.User
	socket   *websocket.Conn
	outbound chan protocol.Envelope
	log      *slog.Logger

	closeOnce sync.Once
	closed    chan struct{}
	closeMsg  string

	heartbeatInterval time.Duration
	lastAckSeq        int64
	mu                sync.Mutex
}

// ID implements Sink.
func (c *Conn) ID() string { return c.id }

// UserID implements Sink.
func (c *Conn) UserID() domain.UserID { return c.user.ID }

// OrganisationID implements Sink.
func (c *Conn) OrganisationID() domain.OrganisationID { return c.user.OrganisationID }

// Send implements Sink. It never blocks: a full queue means the client is not
// keeping up and should be dropped by the caller.
func (c *Conn) Send(env protocol.Envelope) bool {
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.outbound <- env:
		return true
	default:
		return false
	}
}

// Close ends the connection once, recording why.
func (c *Conn) Close(reason string) {
	c.closeOnce.Do(func() {
		c.closeMsg = reason
		close(c.closed)
	})
}

// LastAckSeq is the last heartbeat sequence the client acknowledged.
func (c *Conn) LastAckSeq() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastAckSeq
}

// ServeOptions configures a connection.
type ServeOptions struct {
	HeartbeatInterval time.Duration
	SendQueue         int
	Logger            *slog.Logger
	// OnReady is called once the hello handshake has been sent, so the caller
	// can push an initial snapshot.
	OnReady func(*Conn)
	// OnMessage handles a validated inbound envelope.
	OnMessage func(context.Context, *Conn, protocol.Envelope) error
}

// Serve runs the read/write loops until the connection ends. It owns the
// socket lifecycle: on return, the socket is closed.
func Serve(ctx context.Context, socket *websocket.Conn, id string, user domain.User, hub *Hub, opts ServeOptions) {
	interval := opts.HeartbeatInterval
	if interval <= 0 {
		interval = DefaultHeartbeatInterval
	}
	queue := opts.SendQueue
	if queue <= 0 {
		queue = DefaultSendQueue
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	conn := &Conn{
		id:                id,
		user:              user,
		socket:            socket,
		outbound:          make(chan protocol.Envelope, queue),
		log:               log,
		closed:            make(chan struct{}),
		heartbeatInterval: interval,
	}
	socket.SetReadLimit(maxMessageBytes)

	hub.Add(conn)
	defer hub.Remove(conn.id)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	hello, err := protocol.NewEnvelope(protocol.TypeHelloOK, protocol.HelloOKPayload{
		ConnectionID:      conn.id,
		UserID:            string(user.ID),
		OrganisationID:    string(user.OrganisationID),
		ProtocolVersion:   protocol.Version,
		HeartbeatInterval: int(interval / time.Millisecond),
	})
	if err != nil {
		conn.Close("failed to build hello")
		return
	}
	if err := writeEnvelope(ctx, socket, hello); err != nil {
		conn.Close("failed to send hello")
		return
	}
	if opts.OnReady != nil {
		opts.OnReady(conn)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		conn.readLoop(ctx, opts)
		cancel()
	}()

	conn.writeLoop(ctx)
	cancel()
	// Reading blocks until the socket closes, so close it before waiting.
	_ = socket.Close(websocket.StatusNormalClosure, truncateReason(conn.closeMsg))
	wg.Wait()
}

func (c *Conn) readLoop(ctx context.Context, opts ServeOptions) {
	for {
		msgType, data, err := c.socket.Read(ctx)
		if err != nil {
			c.Close("read: " + err.Error())
			return
		}
		if msgType != websocket.MessageText {
			c.rejectMalformed(ctx, protocol.CodeMalformedMessage, "only text frames are accepted")
			continue
		}

		env, err := protocol.Decode(data)
		if err != nil {
			code := protocol.CodeMalformedMessage
			if errors.Is(err, protocol.ErrUnsupportedVersion) {
				code = protocol.CodeUnsupportedProtocolVersion
			}
			// A malformed message is rejected and reported, never guessed at,
			// and never fatal to the connection.
			c.rejectMalformed(ctx, code, err.Error())
			continue
		}

		switch env.Type {
		case protocol.TypeHeartbeatAck:
			var payload protocol.HeartbeatPayload
			if err := protocol.DecodePayload(env, &payload); err != nil {
				c.rejectMalformed(ctx, protocol.CodeMalformedMessage, err.Error())
				continue
			}
			c.mu.Lock()
			c.lastAckSeq = payload.Seq
			c.mu.Unlock()
		default:
			if opts.OnMessage == nil {
				c.rejectMalformed(ctx, protocol.CodeUnknownMessageType, "unsupported message type "+env.Type)
				continue
			}
			if err := opts.OnMessage(ctx, c, env); err != nil {
				c.rejectMalformed(ctx, protocol.CodeMalformedMessage, err.Error())
			}
		}
	}
}

func (c *Conn) writeLoop(ctx context.Context) {
	ticker := time.NewTicker(c.heartbeatInterval)
	defer ticker.Stop()

	var seq int64
	for {
		select {
		case <-ctx.Done():
			c.Close("server shutting down")
			return
		case <-c.closed:
			return
		case env := <-c.outbound:
			if err := writeEnvelope(ctx, c.socket, env); err != nil {
				c.Close("write: " + err.Error())
				return
			}
		case <-ticker.C:
			seq++
			beat, err := protocol.NewEnvelope(protocol.TypeHeartbeat, protocol.HeartbeatPayload{Seq: seq})
			if err != nil {
				c.Close("heartbeat encode failed")
				return
			}
			if err := writeEnvelope(ctx, c.socket, beat); err != nil {
				// A broken pipe surfaces here even when the client never sends.
				c.Close("heartbeat write: " + err.Error())
				return
			}
		}
	}
}

func (c *Conn) rejectMalformed(ctx context.Context, code protocol.ErrorCode, message string) {
	c.log.Warn("rejected realtime message",
		"connectionId", c.id, "userId", string(c.user.ID), "code", string(code), "reason", message)
	env, err := protocol.NewEnvelope(protocol.TypeError, protocol.ErrorPayload{
		Code:          code,
		Message:       message,
		ServerVersion: protocol.Version,
	})
	if err != nil {
		return
	}
	_ = writeEnvelope(ctx, c.socket, env)
}

func writeEnvelope(ctx context.Context, socket *websocket.Conn, env protocol.Envelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return socket.Write(writeCtx, websocket.MessageText, data)
}

func truncateReason(reason string) string {
	if len(reason) > 100 {
		return reason[:100]
	}
	if reason == "" {
		return "closing"
	}
	return reason
}
