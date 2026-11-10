FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates cmake make gcc g++ zlib1g-dev libbz2-dev libssl-dev hfsprogs imagemagick python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/mozilla/libdmg-hfsplus /src && cd /src && cmake -B build . && make -C build -j8 && cp build/dmg/dmg build/hfs/hfsplus /usr/local/bin/
# dsstore.py writes the Finder layout for each volume name.
RUN pip install --break-system-packages ds_store==1.3.3 mac_alias==2.2.3
