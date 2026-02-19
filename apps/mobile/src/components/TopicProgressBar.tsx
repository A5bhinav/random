import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { SessionSegment } from '@coach/shared';

interface Props {
  segments: SessionSegment[];
  currentIndex: number;
}

export function TopicProgressBar({ segments, currentIndex }: Props) {
  if (segments.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>
        Topic {currentIndex + 1} of {segments.length}
        {segments[currentIndex] ? ` · ${segments[currentIndex].name}` : ''}
      </Text>
      <View style={styles.track}>
        {segments.map((seg, i) => (
          <View
            key={seg.segment_id}
            style={[
              styles.segment,
              i < currentIndex && styles.done,
              i === currentIndex && styles.active,
              i > currentIndex && styles.pending,
              i < segments.length - 1 && styles.segmentGap,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  label: {
    fontSize: 12,
    color: '#a0aec0',
    marginBottom: 6,
    textAlign: 'center',
  },
  track: {
    flexDirection: 'row',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    borderRadius: 2,
  },
  segmentGap: {
    marginRight: 3,
  },
  done: {
    backgroundColor: '#68d391',
  },
  active: {
    backgroundColor: '#63b3ed',
  },
  pending: {
    backgroundColor: '#2d3748',
  },
});
