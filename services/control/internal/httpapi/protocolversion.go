package httpapi

import (
	"net/http"
	"strconv"

	"github.com/layup-app/layup/protocol"
)

// requireProtocolVersion guards every versioned API route.
//
// Discovery endpoints (/healthz) stay outside this guard so a client speaking
// the wrong version can still learn what the server speaks and say something
// useful to the user instead of failing opaquely.
func (s *Server) requireProtocolVersion(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get(protocol.HeaderVersion)
		if raw == "" {
			s.writeProtocolError(w, r, http.StatusBadRequest, protocol.CodeMalformedMessage,
				"missing "+protocol.HeaderVersion+" header", 0)
			return
		}
		version, err := strconv.Atoi(raw)
		if err != nil || version < 1 {
			s.writeProtocolError(w, r, http.StatusBadRequest, protocol.CodeMalformedMessage,
				protocol.HeaderVersion+" must be a positive integer", 0)
			return
		}
		if !protocol.SupportsVersion(version) {
			s.writeProtocolError(w, r, http.StatusUpgradeRequired, protocol.CodeUnsupportedProtocolVersion,
				"client speaks v"+raw+", this server speaks v"+strconv.Itoa(protocol.Version), version)
			return
		}
		w.Header().Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
		next.ServeHTTP(w, r)
	})
}

func (s *Server) writeProtocolError(
	w http.ResponseWriter,
	r *http.Request,
	status int,
	code protocol.ErrorCode,
	message string,
	receivedVersion int,
) {
	s.log.Warn("rejected request at the protocol boundary",
		"path", r.URL.Path,
		"code", string(code),
		"receivedVersion", receivedVersion,
		"serverVersion", protocol.Version,
	)
	payload := protocol.ErrorPayload{
		Code:            code,
		Message:         message,
		ServerVersion:   protocol.Version,
		ReceivedVersion: receivedVersion,
	}
	env, err := protocol.NewEnvelope(protocol.TypeError, payload)
	if err != nil {
		http.Error(w, message, status)
		return
	}
	w.Header().Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
	writeJSON(w, status, env)
}

// ProtocolInfo is the payload of GET /api/protocol.
type ProtocolInfo struct {
	Version int `json:"version"`
}

func (s *Server) handleProtocolInfo(w http.ResponseWriter, _ *http.Request) {
	env, err := protocol.NewEnvelope("protocol.info", ProtocolInfo{Version: protocol.Version})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, env)
}
