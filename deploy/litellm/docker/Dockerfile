ARG LITELLM_IMAGE=ghcr.io/berriai/litellm:v1.99.1
FROM ${LITELLM_IMAGE} AS hook-dependencies
USER root
COPY requirements.txt /opt/litellm-hooks/requirements.txt
RUN python -m ensurepip && python -m pip install --no-cache-dir --target /opt/hook-vendor -r /opt/litellm-hooks/requirements.txt

# Inherit the original image's runtime user; root is used only in the build stage.
FROM ${LITELLM_IMAGE}
COPY --from=hook-dependencies /opt/hook-vendor /opt/litellm-hooks/vendor
ARG PYTHONPATH
ENV PYTHONPATH=/opt/litellm-hooks/vendor:${PYTHONPATH}
COPY hooks /opt/litellm-hooks/hooks
COPY start.py register.py upgrade.py /opt/litellm-hooks/
ENTRYPOINT ["python", "-m", "uvicorn", "start:create_app", "--factory", "--app-dir", "/opt/litellm-hooks"]
CMD ["--host", "0.0.0.0", "--port", "9108", "--workers", "2"]
