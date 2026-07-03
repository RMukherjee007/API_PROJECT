FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8082
CMD ["node", "src/yield-engine/src/index.js"]
