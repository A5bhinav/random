import React, { useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  StatusBar,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSession } from '../hooks/useSession';
import { TimerDisplay } from '../components/TimerDisplay';
import { TopicProgressBar } from '../components/TopicProgressBar';
import { TranscriptArea } from '../components/TranscriptArea';
import type { RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Session'>;

const EXTEND_MS = 5 * 60 * 1000; // 5 minutes

export function SessionScreen({ route, navigation }: Props) {
  const { contentId, durationMs } = route.params;
  const session = useSession(contentId, durationMs);

  const handleExtend = useCallback(() => {
    session.extend(EXTEND_MS);
  }, [session]);

  // ── Ended screen ───────────────────────────────────────────────────────────

  if (session.phase === 'ended') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <View style={styles.endedContainer}>
          <Text style={styles.endedTitle}>Session Complete</Text>
          {session.scorecard ? (
            <ScrollView
              style={styles.scorecardScroll}
              contentContainerStyle={styles.scorecardContent}
            >
              <Text style={styles.scorecardLabel}>Your Scorecard</Text>
              <Text style={styles.scorecardText}>{session.scorecard}</Text>
            </ScrollView>
          ) : (
            <Text style={styles.endedSubtitle}>Great work!</Text>
          )}
          <TouchableOpacity style={styles.doneBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Error screen ───────────────────────────────────────────────────────────

  if (session.phase === 'error') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.endedContainer}>
          <Text style={styles.errorTitle}>Connection Error</Text>
          <Text style={styles.errorMessage}>{session.error ?? 'Something went wrong.'}</Text>
          <TouchableOpacity style={styles.doneBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.doneBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Active session ─────────────────────────────────────────────────────────

  const isConnecting = session.phase === 'connecting' || session.phase === 'authenticating';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.session}>

        {/* Header: timer + extend */}
        <View style={styles.header}>
          <TimerDisplay remainingMs={session.timeRemainingMs} />
          <TouchableOpacity
            style={[styles.extendBtn, isConnecting && styles.disabledBtn]}
            onPress={handleExtend}
            disabled={isConnecting}
          >
            <Text style={styles.extendBtnText}>+5 min</Text>
          </TouchableOpacity>
        </View>

        {/* Topic progress bar */}
        {session.plan && (
          <TopicProgressBar
            segments={session.plan.segments}
            currentIndex={session.currentSegmentIndex}
          />
        )}

        {/* Warning banners */}
        {session.timeRemainingMs > 0 && session.timeRemainingMs <= 15_000 && (
          <View style={[styles.banner, styles.bannerCritical]}>
            <Text style={styles.bannerText}>⏰ 15 seconds remaining</Text>
          </View>
        )}
        {session.timeRemainingMs > 15_000 && session.timeRemainingMs <= 60_000 && (
          <View style={[styles.banner, styles.bannerWarning]}>
            <Text style={styles.bannerText}>⏱ Less than 1 minute remaining</Text>
          </View>
        )}
        {session.timeRemainingMs > 60_000 && session.timeRemainingMs <= 120_000 && (
          <View style={[styles.banner, styles.bannerInfo]}>
            <Text style={styles.bannerText}>2 minutes remaining</Text>
          </View>
        )}

        {/* Server interrupt banner */}
        {session.isInterrupting && (
          <View style={[styles.banner, styles.bannerInterrupt]}>
            <Text style={styles.bannerText}>
              {session.interruptMessage || 'AI redirecting…'}
            </Text>
          </View>
        )}

        {/* Connecting overlay */}
        {isConnecting && (
          <View style={styles.connectingBanner}>
            <Text style={styles.connectingText}>Connecting…</Text>
          </View>
        )}

        {/* Transcript area */}
        <TranscriptArea
          transcript={session.transcript}
          coachCaption={session.coachCaption}
          isAISpeaking={session.isAISpeaking}
          isUserSpeaking={session.isUserSpeaking}
        />

        {/* Footer: mic / interrupt controls */}
        <View style={styles.footer}>
          {session.isAISpeaking ? (
            <TouchableOpacity
              style={styles.bargeInBtn}
              onPress={session.bargeIn}
              activeOpacity={0.7}
            >
              <Text style={styles.bargeInIcon}>✋</Text>
              <Text style={styles.bargeInText}>Interrupt</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.micBtn,
                session.isUserSpeaking && styles.micBtnActive,
                (isConnecting || session.isInterrupting) && styles.disabledBtn,
              ]}
              onPressIn={session.startSpeaking}
              onPressOut={session.stopSpeaking}
              disabled={isConnecting || session.isInterrupting}
              activeOpacity={0.8}
            >
              <Text style={styles.micIcon}>
                {session.isUserSpeaking ? '🔴' : '🎤'}
              </Text>
              <Text style={styles.micText}>
                {session.isUserSpeaking ? 'Speaking…' : 'Hold to Speak'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  session: {
    flex: 1,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1a202c',
  },
  extendBtn: {
    backgroundColor: '#1a365d',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: '#2b6cb0',
  },
  extendBtnText: {
    color: '#90cdf4',
    fontSize: 13,
    fontWeight: '600',
  },

  // Banners
  banner: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  bannerText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  bannerWarning: {
    backgroundColor: '#744210',
  },
  bannerCritical: {
    backgroundColor: '#742a2a',
  },
  bannerInfo: {
    backgroundColor: '#1a365d',
  },
  bannerInterrupt: {
    backgroundColor: '#44337a',
  },
  connectingBanner: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  connectingText: {
    color: '#4a5568',
    fontSize: 13,
  },

  // Mic / barge-in
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 24,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#1a202c',
  },
  micBtn: {
    backgroundColor: '#1a202c',
    borderRadius: 20,
    paddingVertical: 18,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#2d3748',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
  },
  micBtnActive: {
    backgroundColor: '#1a365d',
    borderColor: '#3182ce',
  },
  micIcon: {
    fontSize: 22,
  },
  micText: {
    color: '#a0aec0',
    fontSize: 16,
    fontWeight: '600',
  },
  bargeInBtn: {
    backgroundColor: '#2d2a4e',
    borderRadius: 20,
    paddingVertical: 18,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#6b46c1',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
  },
  bargeInIcon: {
    fontSize: 22,
  },
  bargeInText: {
    color: '#b794f4',
    fontSize: 16,
    fontWeight: '600',
  },
  disabledBtn: {
    opacity: 0.4,
  },

  // Ended / error
  endedContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingVertical: 40,
    justifyContent: 'center',
  },
  endedTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#e2e8f0',
    marginBottom: 12,
    textAlign: 'center',
  },
  endedSubtitle: {
    fontSize: 18,
    color: '#718096',
    textAlign: 'center',
    marginBottom: 40,
  },
  scorecardScroll: {
    flex: 1,
    marginBottom: 24,
  },
  scorecardContent: {
    paddingBottom: 16,
  },
  scorecardLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#718096',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
    textAlign: 'center',
  },
  scorecardText: {
    fontSize: 15,
    color: '#cbd5e0',
    lineHeight: 22,
    backgroundColor: '#1a202c',
    borderRadius: 12,
    padding: 16,
  },
  doneBtn: {
    backgroundColor: '#3182ce',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  doneBtnText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fc8181',
    textAlign: 'center',
    marginBottom: 12,
  },
  errorMessage: {
    fontSize: 15,
    color: '#718096',
    textAlign: 'center',
    marginBottom: 40,
  },
});
