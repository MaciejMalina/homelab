FROM python:3.12-slim
RUN pip install --no-cache-dir flask
COPY app.py /app/app.py
WORKDIR /app
EXPOSE 8098
CMD ["python", "app.py"]
