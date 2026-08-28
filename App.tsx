import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { initSchema } from './src/db/schema';
import type { RootStackParamList, TabParamList } from './src/screens/types';
import { RouteLibraryScreen } from './src/screens/RouteLibraryScreen';
import { PostRideScreen } from './src/screens/PostRideScreen';
import { DeviceScreen } from './src/screens/DeviceScreen';
import { RidesScreen } from './src/screens/RidesScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { FloatingTabBar } from './src/components/FloatingTabBar';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

// The four pages, each with the floating icon menu overlaid.
function Tabs() {
  return (
    <Tab.Navigator
      tabBar={props => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: '#0f0f0f' },
      }}
    >
      <Tab.Screen name="RouteLibrary" component={RouteLibraryScreen} />
      <Tab.Screen name="Device" component={DeviceScreen} />
      <Tab.Screen name="Rides" component={RidesScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  useEffect(() => {
    initSchema();
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar style="light" />
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#0f0f0f' },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="Tabs" component={Tabs} />
          <Stack.Screen name="PostRide" component={PostRideScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
