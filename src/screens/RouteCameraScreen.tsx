import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Svg, { Rect, Circle, Path } from 'react-native-svg';
import type { RootStackParamList } from './types';
import type { ScanMimeType } from '../import/route-scan-result';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ScanCamera'> };

// The Scan flow: a plain viewfinder aimed at the route sheet. The small
// library button lets the rider grab an older photo without leaving the
// camera. Either path replaces this screen with the scan review.
export function RouteCameraScreen({ navigation }: Props) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);

  function goReview(uri: string, mimeType: ScanMimeType, label: string) {
    navigation.replace('ScanReview', { uri, mimeType, label });
  }

  async function capture() {
    if (busy || !cameraRef.current) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      if (photo?.uri) goReview(photo.uri, 'image/jpeg', 'Photo');
    } finally {
      setBusy(false);
    }
  }

  async function pickFromLibrary() {
    if (busy) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    const asset = res.assets[0];
    const mimeType: ScanMimeType = asset.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    goReview(asset.uri, mimeType, 'Photo');
  }

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.permissionBox]}>
        <Text style={styles.permissionText}>
          Camera access is needed to photograph the route sheet.
        </Text>
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Allow Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.permissionCancel} onPress={() => navigation.goBack()}>
          <Text style={styles.permissionCancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      <TouchableOpacity style={styles.closeButton} onPress={() => navigation.goBack()}>
        <Text style={styles.closeText}>×</Text>
      </TouchableOpacity>

      <View style={styles.bottomBar}>
        {/* Photo library shortcut */}
        <TouchableOpacity style={styles.libraryButton} onPress={pickFromLibrary}>
          <Svg width={26} height={26} viewBox="0 0 24 24" fill="none"
            stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <Rect x="3" y="3" width="18" height="18" rx="2" />
            <Circle cx="8.5" cy="8.5" r="1.5" />
            <Path d="M21 15l-5-5L5 21" />
          </Svg>
        </TouchableOpacity>

        {/* Shutter */}
        <TouchableOpacity
          style={[styles.shutter, busy && styles.shutterBusy]}
          onPress={capture}
          disabled={busy}
        >
          <View style={styles.shutterInner} />
        </TouchableOpacity>

        {/* Spacer mirroring the library button, keeps the shutter centered */}
        <View style={styles.libraryButton} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  closeButton: {
    position: 'absolute', top: 56, left: 20, width: 40, height: 40,
    borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  closeText: { color: '#fff', fontSize: 26, lineHeight: 28, fontWeight: '600' },
  bottomBar: {
    position: 'absolute', left: 0, right: 0, bottom: 48,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly',
  },
  libraryButton: {
    width: 48, height: 48, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterBusy: { opacity: 0.5 },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
  permissionBox: { alignItems: 'center', justifyContent: 'center', padding: 32 },
  permissionText: { color: '#fff', fontSize: 16, textAlign: 'center', marginBottom: 24 },
  permissionButton: {
    backgroundColor: '#FF6600', paddingVertical: 14, paddingHorizontal: 32,
    borderRadius: 10,
  },
  permissionButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
  permissionCancel: { marginTop: 16, padding: 8 },
  permissionCancelText: { color: '#888', fontSize: 14 },
});
