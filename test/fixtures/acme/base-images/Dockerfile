ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
