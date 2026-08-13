package httpapi

import (
	"context"
	"time"
)

// DefaultExpirySweep is how often the server looks for requests whose time has
// run out. Expiry itself is deterministic (it depends only on the deadline);
// the sweep only decides how promptly everyone is *told*.
const DefaultExpirySweep = time.Second

// SweepExpiredRequests expires everything due and tells both sides. It is safe
// to call at any time and returns how many requests expired.
func (s *Server) SweepExpiredRequests(ctx context.Context) int {
	expired := s.requests.ExpireDue(ctx)
	for _, request := range expired {
		s.log.InfoContext(ctx, "join request expired",
			"requestId", string(request.ID),
			"type", string(request.Type),
			"fromUserId", string(request.FromUserID),
		)
		// Both sides must see it disappear, not discover it by clicking.
		s.publishResolution(ctx, request)
	}
	return len(expired)
}

// StartExpirySweeper runs SweepExpiredRequests until the context is cancelled.
func (s *Server) StartExpirySweeper(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = DefaultExpirySweep
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.SweepExpiredRequests(ctx)
			}
		}
	}()
}
