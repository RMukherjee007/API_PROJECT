FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm install --omit=dev
COPY --chown=node:node . .
EXPOSE 8080
CMD ["node", "src/gateway/index.js"]
