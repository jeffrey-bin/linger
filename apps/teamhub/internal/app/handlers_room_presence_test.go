package app

import (
	"strconv"
	"testing"
	"time"
)

func TestRoomPresenceThrottle(t *testing.T) {
	var throttle roomPresenceThrottle
	start := time.Unix(1_700_000_000, 0)
	if !throttle.allow("account\x00room", start) {
		t.Fatal("first hint was throttled")
	}
	if throttle.allow("account\x00room", start.Add(roomPresenceInterval-time.Millisecond)) {
		t.Fatal("repeat inside the interval was allowed")
	}
	if !throttle.allow("account\x00other-room", start) {
		t.Fatal("another Room shared the throttle key")
	}
	if !throttle.allow("account\x00room", start.Add(roomPresenceInterval)) {
		t.Fatal("hint after the interval was throttled")
	}
	throttle.forget("account\x00room")
	if !throttle.allow("account\x00room", start.Add(roomPresenceInterval)) {
		t.Fatal("an undelivered hint kept its throttle window")
	}
}

func TestRoomPresenceThrottleStaysBounded(t *testing.T) {
	var throttle roomPresenceThrottle
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < roomPresenceCapacity*2; i++ {
		throttle.allow(strconv.Itoa(i), now)
	}
	if len(throttle.seen) > roomPresenceCapacity {
		t.Fatalf("throttle kept %d keys", len(throttle.seen))
	}
}

func TestRoomPresenceRecentlyPresent(t *testing.T) {
	var throttle roomPresenceThrottle
	start := time.Unix(1_700_000_000, 0)
	if throttle.recentlyPresent("room", start) {
		t.Fatal("unknown Room was present")
	}
	throttle.allow("account\x00room", start)
	if !throttle.recentlyPresent("room", start.Add(roomPresenceRecentWindow-time.Millisecond)) {
		t.Fatal("Room was not present inside the window")
	}
	if throttle.recentlyPresent("room", start.Add(roomPresenceRecentWindow)) {
		t.Fatal("Room stayed present after the window")
	}
	if throttle.recentlyPresent("other-room", start) || throttle.recentlyPresent("oom", start) {
		t.Fatal("another Room shared presence")
	}
}
