import React from 'react';
import { Text, StyleSheet } from 'react-native';

interface Props {
  remainingMs: number;
}

export function TimerDisplay({ remainingMs }: Props) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const label = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const isWarning = remainingMs > 0 && remainingMs <= 60_000;
  const isCritical = remainingMs > 0 && remainingMs <= 15_000;

  return (
    <Text
      style={[
        styles.timer,
        isWarning && styles.warning,
        isCritical && styles.critical,
      ]}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  timer: {
    fontSize: 32,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    color: '#e2e8f0',
    letterSpacing: 2,
  },
  warning: {
    color: '#f6ad55',
  },
  critical: {
    color: '#fc8181',
  },
});
