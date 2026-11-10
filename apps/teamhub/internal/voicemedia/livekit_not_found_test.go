package voicemedia

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"
	spb "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
)

// liveKitErrorServer answers every Room Service call with a Twirp error in
// LiveKit's wire format.
func liveKitErrorServer(t *testing.T, httpStatus int, body map[string]any) *LiveKitProvider {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListParticipants", "/twirp/livekit.RoomService/DeleteRoom":
		default:
			t.Errorf("unexpected LiveKit method %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpStatus)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(server.Close)
	provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: server.URL, APIKey: "test", APISecret: "test-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func assertLiveKitNotFoundBehavior(t *testing.T, provider *LiveKitProvider) {
	t.Helper()
	session := providerSession{RoomName: "voice-room", ParticipantIdentity: "human", RequirePublisher: true}
	if generation, err := provider.InputReadyGeneration(t.Context(), session, 1); generation != 0 || err != nil {
		t.Fatalf("InputReadyGeneration = %d, %v", generation, err)
	}
	if err := provider.RevokePublisher(t.Context(), session); err != nil {
		t.Fatalf("RevokePublisher = %v", err)
	}
	if err := provider.EnsureSession(t.Context(), session); !errors.Is(err, errPublisherAbsent) {
		t.Fatalf("EnsureSession = %v", err)
	}
}

func TestLiveKitTwirpNotFoundReachesTwirpError(t *testing.T) {
	provider := liveKitErrorServer(t, http.StatusNotFound, map[string]any{
		"code": "not_found", "msg": "requested room does not exist",
	})
	_, err := provider.rooms.ListParticipants(t.Context(), &livekit.ListParticipantsRequest{Room: "voice-room"})
	var twirpErr twirp.Error
	if !errors.As(err, &twirpErr) || twirpErr.Code() != twirp.NotFound {
		t.Fatalf("raw LiveKit client error = %#v", err)
	}
	if !isLiveKitNotFound(err) {
		t.Fatalf("Twirp not_found was not recognized: %v", err)
	}
	assertLiveKitNotFoundBehavior(t, provider)
}

func TestLiveKitErrorDetailsNotFoundReachesGRPCStatus(t *testing.T) {
	detail, err := anypb.New(&livekit.Room{Name: "voice-room"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := proto.Marshal(&spb.Status{Code: int32(codes.NotFound), Message: "gone", Details: []*anypb.Any{detail}})
	if err != nil {
		t.Fatal(err)
	}
	provider := liveKitErrorServer(t, http.StatusNotFound, map[string]any{
		"code": "not_found", "msg": "gone",
		"meta": map[string]string{"error_details": base64.StdEncoding.EncodeToString(encoded)},
	})
	_, err = provider.rooms.ListParticipants(t.Context(), &livekit.ListParticipantsRequest{Room: "voice-room"})
	var twirpErr twirp.Error
	if errors.As(err, &twirpErr) || status.Code(err) != codes.NotFound {
		t.Fatalf("raw LiveKit client error = %#v", err)
	}
	if !isLiveKitNotFound(err) {
		t.Fatalf("gRPC NotFound was not recognized: %v", err)
	}
	assertLiveKitNotFoundBehavior(t, provider)
}

func TestLiveKitNotFoundIgnoresMessageText(t *testing.T) {
	provider := liveKitErrorServer(t, http.StatusInternalServerError, map[string]any{
		"code": "internal", "msg": "upstream not found",
	})
	_, err := provider.rooms.ListParticipants(t.Context(), &livekit.ListParticipantsRequest{Room: "voice-room"})
	if err == nil || isLiveKitNotFound(err) {
		t.Fatalf("Internal error with not-found wording was treated as not found: %v", err)
	}
	if isLiveKitNotFound(errors.New("room not found")) {
		t.Fatal("plain error text was treated as not found")
	}
	session := providerSession{RoomName: "voice-room", ParticipantIdentity: "human", RequirePublisher: true}
	if err := provider.RevokePublisher(t.Context(), session); err == nil {
		t.Fatal("RevokePublisher hid an Internal error")
	}
}
