module github.com/simplexai-labs/linger/apps/computer/local-daemon

go 1.26.0

require (
	github.com/Microsoft/go-winio v0.6.3
	github.com/google/uuid v1.6.0
	github.com/gorilla/websocket v1.5.3
	github.com/klauspost/compress v1.18.0
	github.com/pelletier/go-toml/v2 v2.3.0
	github.com/simplexai-labs/linger/contracts-go/runnergateway v0.0.0-00010101000000-000000000000
	golang.org/x/net v0.56.0
	golang.org/x/sys v0.48.0
	golang.org/x/term v0.44.0
	golang.org/x/text v0.39.0
	gopkg.in/yaml.v3 v3.0.1
	modernc.org/sqlite v1.60.1
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	modernc.org/libc v1.77.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)

replace github.com/simplexai-labs/linger/contracts-go/runnergateway => ../../../contracts/generated/go/runnergateway
