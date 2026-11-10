package localtools

import "golang.org/x/sys/windows/registry"

func windowsDefaultBrowserProgID() string {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, _, err := key.GetStringValue("ProgId")
	if err != nil {
		return ""
	}
	return value
}
