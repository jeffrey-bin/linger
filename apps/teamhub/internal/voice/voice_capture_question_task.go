package voice

import (
	"errors"
)

// ErrVoiceCaptureQuestionSent reports a task request that was sent already.
var ErrVoiceCaptureQuestionSent = errors.New("recording task request was already sent")
