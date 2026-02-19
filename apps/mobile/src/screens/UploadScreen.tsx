import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  SafeAreaView,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { getToken } from '../services/auth';
import { Config } from '../config';
import type { RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Upload'>;

const DURATIONS_MIN = [5, 10, 15, 20];

const SUPPORTED_TYPES = [
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

interface PickedFile {
  name: string;
  uri: string;
  mimeType: string;
}

export function UploadScreen({ navigation }: Props) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [durationMins, setDurationMins] = useState(10);
  const [uploading, setUploading] = useState(false);

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: SUPPORTED_TYPES,
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets.length > 0) {
        const asset = result.assets[0];
        setFile({
          name: asset.name,
          uri: asset.uri,
          mimeType: asset.mimeType ?? 'application/octet-stream',
        });
      }
    } catch {
      Alert.alert('Error', 'Could not open file picker.');
    }
  };

  const startSession = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const token = await getToken();

      const formData = new FormData();
      formData.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.mimeType,
      } as unknown as Blob);

      const res = await fetch(`${Config.BACKEND_URL}/v1/content`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        Alert.alert('Upload failed', (err as { message: string }).message);
        return;
      }

      const { content_id } = (await res.json()) as { content_id: string };
      navigation.replace('Session', {
        contentId: content_id,
        durationMs: durationMins * 60 * 1000,
      });
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>Coach</Text>
        <Text style={styles.subtitle}>Upload your study material to begin</Text>

        {/* File picker */}
        <TouchableOpacity
          style={[styles.filePicker, file && styles.filePickerSelected]}
          onPress={pickFile}
          disabled={uploading}
        >
          {file ? (
            <>
              <Text style={styles.fileIcon}>📄</Text>
              <Text style={styles.fileName} numberOfLines={2}>
                {file.name}
              </Text>
              <Text style={styles.fileHint}>Tap to change</Text>
            </>
          ) : (
            <>
              <Text style={styles.fileIcon}>＋</Text>
              <Text style={styles.filePickerText}>Select PDF or PPTX</Text>
              <Text style={styles.fileHint}>Up to 20 MB</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Duration picker */}
        <Text style={styles.sectionLabel}>Session length</Text>
        <View style={styles.durationRow}>
          {DURATIONS_MIN.map((d) => (
            <TouchableOpacity
              key={d}
              style={[styles.durationBtn, durationMins === d && styles.durationBtnActive]}
              onPress={() => setDurationMins(d)}
              disabled={uploading}
            >
              <Text
                style={[
                  styles.durationText,
                  durationMins === d && styles.durationTextActive,
                ]}
              >
                {d} min
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Start button */}
        <TouchableOpacity
          style={[styles.startBtn, (!file || uploading) && styles.startBtnDisabled]}
          onPress={startSession}
          disabled={!file || uploading}
        >
          {uploading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.startBtnText}>Start Session</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 40,
    paddingBottom: 32,
  },
  title: {
    fontSize: 36,
    fontWeight: '700',
    color: '#e2e8f0',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#718096',
    marginBottom: 36,
  },
  filePicker: {
    borderWidth: 2,
    borderColor: '#2d3748',
    borderStyle: 'dashed',
    borderRadius: 16,
    paddingVertical: 36,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 32,
    backgroundColor: '#1a1a2e',
  },
  filePickerSelected: {
    borderColor: '#63b3ed',
    borderStyle: 'solid',
  },
  fileIcon: {
    fontSize: 32,
    marginBottom: 10,
  },
  filePickerText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#a0aec0',
    marginBottom: 4,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#e2e8f0',
    textAlign: 'center',
    marginBottom: 4,
  },
  fileHint: {
    fontSize: 12,
    color: '#4a5568',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#718096',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  durationRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 40,
  },
  durationBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#1a202c',
    borderWidth: 1,
    borderColor: '#2d3748',
    alignItems: 'center',
  },
  durationBtnActive: {
    backgroundColor: '#2b4c7e',
    borderColor: '#63b3ed',
  },
  durationText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#718096',
  },
  durationTextActive: {
    color: '#90cdf4',
    fontWeight: '600',
  },
  startBtn: {
    backgroundColor: '#3182ce',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 'auto',
  },
  startBtnDisabled: {
    backgroundColor: '#1a365d',
    opacity: 0.5,
  },
  startBtnText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.3,
  },
});
