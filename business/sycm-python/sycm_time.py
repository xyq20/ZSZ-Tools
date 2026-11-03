"""Business dates use Beijing time, independently of the host timezone."""
from datetime import datetime
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo('Asia/Shanghai')


def beijing_now():
    return datetime.now(BEIJING)


def beijing_today():
    return beijing_now().date()
