package transport

import (
	"errors"
	"fmt"
	"net"
	"testing"

	"github.com/gorilla/websocket"
)

func TestIsGatewayRestart(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{"going away", &websocket.CloseError{Code: websocket.CloseGoingAway, Text: "Agent Service shutting down"}, true},
		{"service restart", &websocket.CloseError{Code: websocket.CloseServiceRestart}, true},
		{"wrapped going away", fmt.Errorf("receive: %w", &websocket.CloseError{Code: websocket.CloseGoingAway}), true},
		{"wrapped service restart", fmt.Errorf("receive: %w", &websocket.CloseError{Code: websocket.CloseServiceRestart}), true},
		{"policy violation", &websocket.CloseError{Code: websocket.ClosePolicyViolation}, false},
		{"abnormal closure", &websocket.CloseError{Code: websocket.CloseAbnormalClosure}, false},
		{"upgrade required", &UpgradeRequiredError{Reason: "upgrade_required: protocol"}, false},
		{"unreachable", &GatewayUnreachableError{Err: errors.New("connect Runner Gateway: refused")}, false},
		{"network error", &net.OpError{Op: "read", Err: errors.New("connection reset")}, false},
		{"nil", nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := IsGatewayRestart(test.err); got != test.want {
				t.Fatalf("IsGatewayRestart(%v) = %v, want %v", test.err, got, test.want)
			}
		})
	}
}
