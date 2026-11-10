package voice

import (
	"context"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
)

// VoiceLiveEventsHeartbeat keeps the stream open through proxies and is how
// often the stream checks that the call is still on.
const VoiceLiveEventsHeartbeat = 15 * time.Second

// LiveReplyRoom resolves the Room of a live VoiceSession that can still take
// replies; it reports voicelive.ErrNotFound once the call ended.
func (s *Service) LiveReplyRoom(ctx context.Context, voiceSessionID string) (string, error) {
	session, err := voicelive.ReplySession(ctx, s.queries, voiceSessionID)
	if err != nil {
		return "", err
	}
	return session.RoomID, nil
}
