FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    MAX_UPLOAD_MB=200 \
    SESSION_TTL_SECONDS=7200 \
    WORK_DIR=/tmp/daxart-svg-optimizer
COPY . /app
EXPOSE 8080
CMD ["python", "server.py", "--no-browser"]