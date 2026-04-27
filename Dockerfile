FROM node:22-alpine AS base
WORKDIR /app

COPY backend/package*.json /app/backend/
COPY frontend/package*.json /app/frontend/
RUN cd backend && npm install && cd /app/frontend && npm install

COPY . /app
RUN cd backend && npm run build && cd /app/frontend && npm run build

EXPOSE 3001 5173
CMD ["sh", "-c", "cd backend && npm start"]
