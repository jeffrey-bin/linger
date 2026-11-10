package voicelive

import (
	"regexp"
	"strings"
)

var (
	numberWords = map[string]string{
		"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
		"six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
	}
	letterSpaceDigit = regexp.MustCompile(`(?i)\b([a-z]+)\s+(\d+)\b`)
	letterDigit      = regexp.MustCompile(`(?i)\b([a-z]{4,})(\d+)\b`)
)

// QueryVariants returns the query and, after it, spelled variants of names a
// speech recognizer splits or spells out ("level eight" -> "level8",
// "lev8"), without repeats and at most four in all.
func QueryVariants(query string) []string {
	query = strings.TrimSpace(query)
	variants := []string{query}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || len(variants) >= 4 {
			return
		}
		for _, existing := range variants {
			if strings.EqualFold(existing, value) {
				return
			}
		}
		variants = append(variants, value)
	}
	words := strings.Fields(query)
	for index, word := range words {
		if digit, ok := numberWords[strings.ToLower(word)]; ok {
			words[index] = digit
		}
	}
	digits := strings.Join(words, " ")
	compact := letterSpaceDigit.ReplaceAllString(digits, "$1$2")
	add(compact)
	// A longer spoken word before a number is often a short product name
	// ("level8" for "Lev8"): its first three letters are tried too.
	add(letterDigit.ReplaceAllStringFunc(compact, func(token string) string {
		match := letterDigit.FindStringSubmatch(token)
		return match[1][:3] + match[2]
	}))
	return variants
}
