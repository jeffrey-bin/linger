package database

import "net/url"

// WithDatabase selects a private database while retaining other connection options.
func WithDatabase(controlURL, name string) (string, error) {
	parsed, err := url.Parse(controlURL)
	if err != nil {
		return "", err
	}
	parsed.Path = "/" + name
	parsed.RawPath = ""
	options := parsed.Query()
	options.Del("dbname")
	options.Del("database")
	parsed.RawQuery = options.Encode()
	return parsed.String(), nil
}
