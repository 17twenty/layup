package protocol

// Realtime message types carried inside the shared envelope over WSS.
//
// The realtime channel is control-plane only: presence, membership, social
// requests and signalling. Media and cursor traffic never travel here
// (ARCHITECTURE.md §3).
const (
	// TypeHelloOK is the server's first message: it states who the server
	// thinks you are and which protocol version it is speaking.
	TypeHelloOK = "hello.ok"
	// TypeHeartbeat is sent by the server on a fixed interval. A client that
	// stops seeing it must treat the connection as broken.
	TypeHeartbeat = "heartbeat"
	// TypeHeartbeatAck is the client's reply, which lets the server drop
	// half-open connections.
	TypeHeartbeatAck = "heartbeat.ack"
)

// QueryProtocolVersion and QueryDevUser carry the handshake on the WebSocket
// URL, because the WebSocket client available in the desktop runtime cannot set
// request headers.
const (
	QueryProtocolVersion = "v"
	QueryDevUser         = "devUser"
)

// HelloOKPayload tells a freshly connected client what it is connected as.
type HelloOKPayload struct {
	ConnectionID      string `json:"connectionId"`
	UserID            string `json:"userId"`
	OrganisationID    string `json:"organisationId"`
	ProtocolVersion   int    `json:"protocolVersion"`
	HeartbeatInterval int    `json:"heartbeatIntervalMs"`
}

// HeartbeatPayload carries a monotonically increasing sequence number so a
// client can tell a stalled connection from a slow one.
type HeartbeatPayload struct {
	Seq int64 `json:"seq"`
}
