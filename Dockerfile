FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p uploads && chown node:node uploads
COPY src ./src
USER node
EXPOSE 4000
CMD ["node","src/server.js"]
