FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY assets ./assets
COPY README.md LICENSE ./

ENTRYPOINT ["node", "bin/cli.js"]
