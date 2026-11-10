package jobs

import "time"

// ComputerOfflineRetryDelay is how long a background model job snoozes before
// it asks its owner's Computer again. A snooze does not spend a River attempt.
const ComputerOfflineRetryDelay = 5 * time.Minute

// ComputerOfflineWaitLimit bounds how long a background model job waits for an
// offline Computer. A Computer that stays away longer is treated as gone, so
// the job settles terminally instead of snoozing forever.
const ComputerOfflineWaitLimit = 7 * 24 * time.Hour

// ComputerOfflineWaitExpired reports whether a job that has existed since
// since has reached ComputerOfflineWaitLimit at now.
func ComputerOfflineWaitExpired(since, now time.Time) bool {
	return !since.IsZero() && now.Sub(since) >= ComputerOfflineWaitLimit
}
