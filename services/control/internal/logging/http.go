package logging

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"
)

// HeaderRequestID lets a client correlate its own logs with the server's.
const HeaderRequestID = "X-Layup-Request-ID"

// NewID returns a short random correlation identifier.
func NewID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buf[:])
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

// Middleware attaches a request ID to the context and logs one structured line
// per request. It logs the route and outcome, never bodies or headers.
func Middleware(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := r.Header.Get(HeaderRequestID)
			if requestID == "" {
				requestID = NewID()
			}
			ctx := WithFields(r.Context(), slog.String("requestId", requestID))
			w.Header().Set(HeaderRequestID, requestID)

			recorder := &statusRecorder{ResponseWriter: w}
			started := time.Now()
			next.ServeHTTP(recorder, r.WithContext(ctx))
			if recorder.status == 0 {
				recorder.status = http.StatusOK
			}

			log.InfoContext(ctx, "http request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", recorder.status,
				"bytes", recorder.bytes,
				"durationMs", float64(time.Since(started).Microseconds())/1000.0,
			)
		})
	}
}
