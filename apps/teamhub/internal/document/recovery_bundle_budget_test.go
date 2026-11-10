package document

import "testing"

func TestBundleFitsCountsOneStateWithItsVectorAndReferences(t *testing.T) {
	t.Parallel()
	references := len(`{"document_asset_ids":["asset_a"],"document_thread_ids":["thread_a"]}`)
	if got := BundleDecodedBytes(8, 2, []string{"asset_a"}, []string{"thread_a"}); got != 10+references {
		t.Fatalf("decoded bundle bytes=%d want=%d", got, 10+references)
	}
	empty := len(`{"document_asset_ids":[],"document_thread_ids":[]}`)
	if !BundleFits(BundleDecodedBytesLimit-empty-1, 1, nil, nil) {
		t.Fatal("a bundle at the limit was rejected")
	}
	if BundleFits(BundleDecodedBytesLimit-empty, 1, nil, nil) {
		t.Fatal("a bundle one byte over the limit was accepted")
	}
}
