from loguru import logger
from zax.variables import log_file

logger.add(
    log_file,
    backtrace=True,
    diagnose=True,
    format="{time:YYYY-MM-DD at HH:mm:ss} | {message} {exception}",
    rotation="1 MB",
)


def log(msg):
    logger.info(msg)
