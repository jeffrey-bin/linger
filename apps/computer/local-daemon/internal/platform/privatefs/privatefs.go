// Package privatefs protects local credentials and ownership records using native
// filesystem identity and permissions. Checks apply to opened handles.
package privatefs

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

func ReadFile(path string, maximum int64) ([]byte, error) {
	if maximum <= 0 {
		maximum = 1024 * 1024
	}
	file, err := OpenRead(path, true)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("private file exceeds size limit")
	}
	return data, nil
}

// WriteFile publishes an owner-only file. Exclusive creation never replaces an
// existing identity. Replacement occurs within a protected parent directory.
func WriteFile(path string, data []byte, exclusive bool) error {
	parent := filepath.Dir(path)
	if err := CheckPath(parent, "directory", false); errors.Is(err, os.ErrNotExist) {
		if err := EnsureDir(parent); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if !exclusive {
		if err := CheckPath(path, "file", true); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+hex.EncodeToString(nonce[:])+".tmp")
	file, err := openWrite(temp, true)
	if err != nil {
		return err
	}
	defer os.Remove(temp)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if exclusive {
		// A hard-link publication would leave two names after a crash, which
		// must remain unsafe for credential reads. Rename without replacement
		// publishes one complete, single-link file or leaves the path absent.
		return publishExclusive(temp, path)
	}
	return os.Rename(temp, path)
}
