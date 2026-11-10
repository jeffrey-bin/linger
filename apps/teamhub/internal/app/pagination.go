package app

import httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"

func pageMeta(hasMore bool, cursor string) httpapi.PageMeta {
	page := httpapi.PageMeta{HasMore: hasMore}
	if hasMore && cursor != "" {
		page.NextCursor = &cursor
	}
	return page
}
