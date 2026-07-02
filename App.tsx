import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { initSchema } from './src/db/schema';
import type { RootStackParamList } from './src/screens/types';
import { RouteLibraryScreen } from './src/screens/RouteLibraryScreen';
import { PreRideScreen } from './src/screens/PreRideScreen';
import { LiveRideScreen } from './src/screens/LiveRideScreen';
import { PostRideScreen } from './src/screens/PostRideScreen';
import { DeviceScreen } from './src/screens/DeviceScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  useEffect(() => {
    initSchema();
  }, []);

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0f0f0f' },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="RouteLibrary" component={RouteLibraryScreen} />
        <Stack.Screen name="PreRide" component={PreRideScreen} />
        <Stack.Screen
          name="LiveRide"
          component={LiveRideScreen}
          options={{ gestureEnabled: false }}
        />
        <Stack.Screen name="PostRide" component={PostRideScreen} />
        <Stack.Screen name="Device" component={DeviceScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
