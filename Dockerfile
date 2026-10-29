FROM ubuntu:24.04
WORKDIR /workspace/server
COPY .local/bin/arena-server-linux /usr/local/bin/arena-server
COPY scripts/container-backend.sh /usr/local/bin/container-backend.sh
CMD ["sh", "/usr/local/bin/container-backend.sh"]
