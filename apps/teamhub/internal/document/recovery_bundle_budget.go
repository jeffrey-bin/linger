// Document state bundles must fit the decoded-size budget below.

package document

import "encoding/json"

// BundleDecodedBytesLimit bounds the decoded state, state vector and complete
// references of every Document head, so the Runtime can open it. At 16 MiB a
// whole state still fits one Yjs frame, and the Runtime requests and results
// that carry two states, or a state with its update, stay within the 48 MiB
// request and 46 MiB response limits.
const BundleDecodedBytesLimit = 16 << 20

type references struct {
	DocumentAssetIDs  []string `json:"document_asset_ids"`
	DocumentThreadIDs []string `json:"document_thread_ids"`
}

// BundleDecodedBytes is the decoded size of one state, its vector and the
// complete references as JSON.
func BundleDecodedBytes(stateBytes, stateVectorBytes int, assetIDs, threadIDs []string) int {
	references, _ := json.Marshal(references{
		DocumentAssetIDs:  append([]string{}, assetIDs...),
		DocumentThreadIDs: append([]string{}, threadIDs...),
	})
	return stateBytes + stateVectorBytes + len(references)
}

// BundleFits reports whether a Document head can be opened by the Runtime.
func BundleFits(stateBytes, stateVectorBytes int, assetIDs, threadIDs []string) bool {
	return BundleDecodedBytes(stateBytes, stateVectorBytes, assetIDs, threadIDs) <= BundleDecodedBytesLimit
}
