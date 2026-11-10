//go:build windows

package lingercontext

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

func projectionIdentity(path string) (projectionFileIdentity, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return projectionFileIdentity{}, err
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return projectionFileIdentity{}, err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return projectionFileIdentity{}, err
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
		return projectionFileIdentity{}, errors.New("projection file is unavailable")
	}
	// NTFS ChangeTime also changes when a writer restores LastWriteTime. Both
	// timestamps are needed before reusing a previously verified content hash.
	var basic struct {
		CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
		FileAttributes                                          uint32
	}
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return projectionFileIdentity{}, err
	}
	changed := windows.Filetime{LowDateTime: uint32(basic.ChangeTime), HighDateTime: uint32(basic.ChangeTime >> 32)}
	return projectionFileIdentity{
		Device: uint64(info.VolumeSerialNumber), Inode: uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow),
		Size: int64(info.FileSizeHigh)<<32 | int64(info.FileSizeLow), Mode: info.FileAttributes,
		ModifiedNsec: info.LastWriteTime.Nanoseconds(), ChangedNsec: changed.Nanoseconds(), Cacheable: true,
	}, nil
}
