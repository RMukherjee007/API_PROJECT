FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm install --omit=dev
COPY --chown=node:node . .
EXPOSE 8084
CMD ["node", "src/audit-service/src/index.js"]
