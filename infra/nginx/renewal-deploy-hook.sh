#!/bin/sh
# Install at /etc/letsencrypt/renewal-hooks/deploy/fin-hub-nginx.sh (mode 755).
set -eu
/usr/bin/docker exec docker-nginx-1 nginx -t
/usr/bin/docker exec docker-nginx-1 nginx -s reload
