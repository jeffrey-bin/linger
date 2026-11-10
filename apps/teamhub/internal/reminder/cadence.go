package reminder

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode/utf8"
)

var clockPattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

var weekdayIndex = map[string]time.Weekday{
	"sunday":    time.Sunday,
	"monday":    time.Monday,
	"tuesday":   time.Tuesday,
	"wednesday": time.Wednesday,
	"thursday":  time.Thursday,
	"friday":    time.Friday,
	"saturday":  time.Saturday,
}

func normalizeName(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > maxNameRunes {
		return "", ErrInvalid
	}
	return trimmed, nil
}

func normalizePrompt(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > maxPromptRunes {
		return "", ErrInvalid
	}
	return trimmed, nil
}

func validateCadence(cadence Cadence) (Cadence, error) {
	timezone := strings.TrimSpace(cadence.Timezone)
	if timezone == "" {
		return Cadence{}, ErrInvalid
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return Cadence{}, fmt.Errorf("%w: timezone", ErrInvalid)
	}
	kind := strings.TrimSpace(cadence.Kind)
	switch kind {
	case "daily":
		hour, minute, err := requireClock(cadence.Hour, cadence.Minute)
		if err != nil || cadence.Weekdays != nil || cadence.IntervalHours != nil {
			return Cadence{}, ErrInvalid
		}
		return Cadence{Kind: kind, Timezone: timezone, Hour: &hour, Minute: &minute}, nil
	case "weekly":
		hour, minute, err := requireClock(cadence.Hour, cadence.Minute)
		if err != nil || cadence.IntervalHours != nil {
			return Cadence{}, ErrInvalid
		}
		weekdays, err := normalizeWeekdays(cadence.Weekdays)
		if err != nil {
			return Cadence{}, err
		}
		return Cadence{Kind: kind, Timezone: timezone, Hour: &hour, Minute: &minute, Weekdays: weekdays}, nil
	case "every_n_hours":
		if cadence.IntervalHours == nil || *cadence.IntervalHours < 1 || *cadence.IntervalHours > 168 {
			return Cadence{}, ErrInvalid
		}
		if cadence.Hour != nil || cadence.Minute != nil || cadence.Weekdays != nil {
			return Cadence{}, ErrInvalid
		}
		hours := *cadence.IntervalHours
		return Cadence{Kind: kind, Timezone: timezone, IntervalHours: &hours}, nil
	case "once":
		if cadence.RunAt == nil || cadence.Hour != nil || cadence.Minute != nil ||
			cadence.Weekdays != nil || cadence.IntervalHours != nil {
			return Cadence{}, ErrInvalid
		}
		runAt := cadence.RunAt.UTC().Truncate(time.Second)
		return Cadence{Kind: kind, Timezone: timezone, RunAt: &runAt}, nil
	default:
		return Cadence{}, ErrInvalid
	}
}

func ParseSchedule(schedule Schedule) (Cadence, error) {
	kind := strings.TrimSpace(schedule.Kind)
	switch kind {
	case "daily", "weekly":
		if schedule.IntervalHours != nil || (kind == "daily" && schedule.Weekdays != nil) {
			return Cadence{}, ErrInvalid
		}
		hour, minute, err := parseClock(schedule.Time)
		if err != nil {
			return Cadence{}, err
		}
		cadence := Cadence{
			Kind: kind, Timezone: strings.TrimSpace(schedule.Timezone), Hour: &hour, Minute: &minute,
		}
		if kind == "weekly" {
			cadence.Weekdays = schedule.Weekdays
		}
		return validateCadence(cadence)
	case "every_n_hours":
		if strings.TrimSpace(schedule.Time) != "" || strings.TrimSpace(schedule.Timezone) != "" || schedule.Weekdays != nil || schedule.IntervalHours == nil {
			return Cadence{}, ErrInvalid
		}
		hours := *schedule.IntervalHours
		return validateCadence(Cadence{Kind: kind, Timezone: "UTC", IntervalHours: &hours})
	case "once":
		if strings.TrimSpace(schedule.Time) != "" || schedule.Weekdays != nil ||
			schedule.IntervalHours != nil || schedule.RunAt == nil {
			return Cadence{}, ErrInvalid
		}
		timezone := strings.TrimSpace(schedule.Timezone)
		if timezone == "" {
			timezone = "UTC"
		}
		return validateCadence(Cadence{Kind: kind, Timezone: timezone, RunAt: schedule.RunAt})
	default:
		return Cadence{}, ErrInvalid
	}
}

func ScheduleFromCadence(cadence Cadence) Schedule {
	if cadence.Kind == "every_n_hours" {
		return Schedule{Kind: cadence.Kind, IntervalHours: cadence.IntervalHours}
	}
	if cadence.Kind == "once" {
		return Schedule{Kind: cadence.Kind, Timezone: cadence.Timezone, RunAt: cadence.RunAt}
	}
	schedule := Schedule{Kind: cadence.Kind, Timezone: cadence.Timezone, Weekdays: cadence.Weekdays}
	if cadence.Hour != nil && cadence.Minute != nil {
		schedule.Time = fmt.Sprintf("%02d:%02d", *cadence.Hour, *cadence.Minute)
	}
	return schedule
}

func parseClock(value string) (int, int, error) {
	if !clockPattern.MatchString(value) {
		return 0, 0, ErrInvalid
	}
	hour := int(value[0]-'0')*10 + int(value[1]-'0')
	minute := int(value[3]-'0')*10 + int(value[4]-'0')
	return hour, minute, nil
}

func requireClock(hour, minute *int) (int, int, error) {
	if hour == nil || minute == nil || *hour < 0 || *hour > 23 || *minute < 0 || *minute > 59 {
		return 0, 0, ErrInvalid
	}
	return *hour, *minute, nil
}

// normalizeWeekdays returns one canonical, sorted set of days.
func normalizeWeekdays(days []string) ([]string, error) {
	if len(days) < 1 || len(days) > 7 {
		return nil, ErrInvalid
	}
	result := make([]string, 0, len(days))
	for _, day := range days {
		day = strings.ToLower(strings.TrimSpace(day))
		if _, ok := weekdayIndex[day]; !ok || slices.Contains(result, day) {
			return nil, ErrInvalid
		}
		result = append(result, day)
	}
	slices.SortFunc(result, func(a, b string) int { return (int(weekdayIndex[a])+6)%7 - (int(weekdayIndex[b])+6)%7 })
	return result, nil
}

func nextRunAt(cadence Cadence, after time.Time) (time.Time, error) {
	normalized, err := validateCadence(cadence)
	if err != nil {
		return time.Time{}, err
	}
	after = after.UTC()
	switch normalized.Kind {
	case "daily":
		return nextDaily(*normalized.Hour, *normalized.Minute, normalized.Timezone, after)
	case "weekly":
		var next time.Time
		for _, day := range normalized.Weekdays {
			candidate, err := nextWeekly(*normalized.Hour, *normalized.Minute, day, normalized.Timezone, after)
			if err != nil {
				return time.Time{}, err
			}
			if next.IsZero() || candidate.Before(next) {
				next = candidate
			}
		}
		return next, nil
	case "every_n_hours":
		next := after.Add(time.Duration(*normalized.IntervalHours) * time.Hour)
		if !next.After(after) {
			return time.Time{}, ErrInvalid
		}
		return next, nil
	case "once":
		// A one-shot time already past has no next occurrence.
		if !normalized.RunAt.After(after) {
			return time.Time{}, ErrInvalid
		}
		return *normalized.RunAt, nil
	default:
		return time.Time{}, ErrInvalid
	}
}

func nextDaily(hour, minute int, timezone string, after time.Time) (time.Time, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, err
	}
	local := after.In(location)
	candidate := time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, location)
	if !candidate.After(after) {
		candidate = candidate.AddDate(0, 0, 1)
	}
	if !candidate.After(after) {
		return time.Time{}, ErrInvalid
	}
	return candidate.UTC(), nil
}

func nextWeekly(hour, minute int, weekdayName, timezone string, after time.Time) (time.Time, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, err
	}
	wanted, ok := weekdayIndex[weekdayName]
	if !ok {
		return time.Time{}, ErrInvalid
	}
	local := after.In(location)
	candidate := time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, location)
	days := int(wanted - candidate.Weekday())
	if days < 0 {
		days += 7
	}
	candidate = candidate.AddDate(0, 0, days)
	if !candidate.After(after) {
		candidate = candidate.AddDate(0, 0, 7)
	}
	if !candidate.After(after) {
		return time.Time{}, ErrInvalid
	}
	return candidate.UTC(), nil
}

func maxTime(left, right time.Time) time.Time {
	if right.After(left) {
		return right
	}
	return left
}
