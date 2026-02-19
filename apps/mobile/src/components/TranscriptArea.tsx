import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Props {
  transcript: string;
  coachCaption: string;
  isAISpeaking: boolean;
  isUserSpeaking: boolean;
}

export function TranscriptArea({
  transcript,
  coachCaption,
  isAISpeaking,
  isUserSpeaking,
}: Props) {
  return (
    <View style={styles.container}>
      {isAISpeaking && coachCaption.length > 0 && (
        <View style={styles.coachBubble}>
          <Text style={styles.speakerLabel}>Coach</Text>
          <Text style={styles.coachText}>{coachCaption}</Text>
        </View>
      )}
      {isUserSpeaking && (
        <View style={styles.userBubble}>
          <Text style={styles.speakerLabel}>You</Text>
          <Text style={styles.userText}>
            {transcript.length > 0 ? transcript : '…'}
          </Text>
        </View>
      )}
      {!isAISpeaking && !isUserSpeaking && coachCaption.length > 0 && (
        <View style={styles.coachBubble}>
          <Text style={styles.speakerLabel}>Coach</Text>
          <Text style={styles.coachText}>{coachCaption}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 12,
    justifyContent: 'flex-end',
    gap: 12,
  },
  coachBubble: {
    backgroundColor: '#2d3748',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    padding: 14,
    maxWidth: '85%',
    alignSelf: 'flex-start',
  },
  userBubble: {
    backgroundColor: '#2b6cb0',
    borderRadius: 16,
    borderBottomRightRadius: 4,
    padding: 14,
    maxWidth: '85%',
    alignSelf: 'flex-end',
  },
  speakerLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#a0aec0',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  coachText: {
    fontSize: 16,
    color: '#e2e8f0',
    lineHeight: 22,
  },
  userText: {
    fontSize: 16,
    color: '#fff',
    lineHeight: 22,
    fontStyle: 'italic',
  },
});
