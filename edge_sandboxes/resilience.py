"""Resilience primitives — circuit breaker + retry. Zero external deps."""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

logger = logging.getLogger(__name__)


class CircuitState(Enum):
    CLOSED = "closed"      # Normal operation
    OPEN = "open"          # Failing, reject calls
    HALF_OPEN = "half_open"  # Testing recovery


@dataclass
class RetryConfig:
    max_retries: int = 3
    initial_delay: float = 1.0
    max_delay: float = 30.0
    exponential_base: float = 2.0
    jitter: bool = True


class CircuitBreaker:
    """Lightweight circuit breaker for provider health tracking."""

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        success_threshold: int = 2,
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.success_threshold = success_threshold

        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.success_count = 0
        self.last_failure_time = 0.0

    def is_open(self) -> bool:
        if self.state == CircuitState.OPEN:
            if time.time() - self.last_failure_time >= self.recovery_timeout:
                self.state = CircuitState.HALF_OPEN
                self.success_count = 0
                return False
            return True
        return False

    def record_success(self) -> None:
        if self.state == CircuitState.HALF_OPEN:
            self.success_count += 1
            if self.success_count >= self.success_threshold:
                self._close()
        else:
            self.failure_count = 0

    def record_failure(self) -> None:
        self.failure_count += 1
        self.last_failure_time = time.time()
        if self.state == CircuitState.HALF_OPEN or self.failure_count >= self.failure_threshold:
            self._open()

    def _open(self) -> None:
        self.state = CircuitState.OPEN
        self.success_count = 0
        logger.warning(f"Circuit breaker OPEN after {self.failure_count} failures")

    def _close(self) -> None:
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.success_count = 0
        logger.info("Circuit breaker CLOSED — service recovered")

    def reset(self) -> None:
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.success_count = 0
        self.last_failure_time = 0.0


class RetryHandler:
    """Retry with exponential backoff + jitter."""

    def __init__(self, config: RetryConfig | None = None):
        self.config = config or RetryConfig()

    def delay_for(self, attempt: int) -> float:
        base = self.config.initial_delay * (self.config.exponential_base ** max(0, attempt - 1))
        delay = min(base, self.config.max_delay)
        if self.config.jitter and delay > 0:
            delay *= 1 + random.random() * 0.25
        return min(delay, self.config.max_delay)

    async def execute(self, func: Callable, *args: Any, **kwargs: Any) -> Any:
        last_error: Exception | None = None
        for attempt in range(1, self.config.max_retries + 2):
            try:
                result = func(*args, **kwargs)
                if asyncio.iscoroutine(result):
                    return await result
                return result
            except Exception as e:
                last_error = e
                if attempt > self.config.max_retries:
                    break
                delay = self.delay_for(attempt)
                logger.info(f"Retry {attempt}/{self.config.max_retries} after {delay:.1f}s: {e}")
                await asyncio.sleep(delay)
        raise last_error  # type: ignore
