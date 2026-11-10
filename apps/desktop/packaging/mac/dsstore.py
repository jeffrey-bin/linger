# Finder layout for the Linger DMG: background, window size, icon positions.
# Usage: dsstore.py OUTPUT VOLUME. The background alias names the volume, so
# each version gets its own name and an older mounted DMG cannot capture it.
import datetime, sys
from ds_store import DSStore
from mac_alias import Alias, VolumeInfo, TargetInfo, ALIAS_KIND_FILE, ALIAS_FIXED_DISK
VOLUME = sys.argv[2]
# mkdir /.background then add background.tiff first: HFS+ hands out CNIDs from 16.
BG_DIR_CNID, BG_CNID = 16, 17
now = datetime.datetime.now(datetime.timezone.utc)
alias = Alias(volume=VolumeInfo(VOLUME, now, b"H+", ALIAS_FIXED_DISK, 0, b"\0\0"),
              target=TargetInfo(ALIAS_KIND_FILE, "background.tiff", BG_DIR_CNID, BG_CNID, now,
                                b"\0\0\0\0", b"\0\0\0\0"))
alias.volume.posix_path = "/Volumes/" + VOLUME
alias.target.folder_name = ".background"
alias.target.cnid_path = [BG_DIR_CNID]
alias.target.carbon_path = f"{VOLUME}:.background:background.tiff"
alias.target.posix_path = "/.background/background.tiff"
with DSStore.open(sys.argv[1], "w+") as d:
    d["."]["vSrn"] = ("long", 1)
    d["."]["bwsp"] = {
        "WindowBounds": "{{200, 140}, {640, 428}}",
        "ShowStatusBar": False, "ShowToolbar": False, "ShowTabView": False,
        "ShowPathbar": False, "ShowSidebar": False, "ContainerShowSidebar": False,
        "PreviewPaneVisibility": False, "SidebarWidth": 0,
    }
    d["."]["icvp"] = {
        "viewOptionsVersion": 1, "backgroundType": 2,
        "backgroundImageAlias": alias.to_bytes(),
        "backgroundColorRed": 1.0, "backgroundColorGreen": 1.0, "backgroundColorBlue": 1.0,
        "gridOffsetX": 0.0, "gridOffsetY": 0.0, "gridSpacing": 100.0,
        "arrangeBy": "none", "showIconPreview": False, "showItemInfo": False,
        "labelOnBottom": True, "textSize": 13.0, "iconSize": 112.0,
        "scrollPositionX": 0.0, "scrollPositionY": 0.0,
    }
    d["."]["icvl"] = ("type", b"icnv")
    d["Linger.app"]["Iloc"] = (160, 196)
    d["Applications"]["Iloc"] = (480, 196)
    d[".background"]["Iloc"] = (160, 600)
print("ok")
