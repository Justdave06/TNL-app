import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as React from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AuthProvider, useAuth } from '@/lib/auth'
import { ToastProvider } from '@/lib/toast'
import { colors } from '@/lib/theme'

function RootLayoutNav() {
  const { user, bootstrapping } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  React.useEffect(() => {
    if (bootstrapping) return

    const group = segments[0]
    const inAuthGroup = group === '(auth)'
    const isAdmin = user?.role === 'admin'
    // Admins only ever land in (admin); customers only ever land in (member).
    const home = isAdmin ? '/(admin)' : '/(member)'
    const homeGroup = isAdmin ? '(admin)' : '(member)'

    if (!user && !inAuthGroup) router.replace('/(auth)')
    else if (user && inAuthGroup) router.replace(home)
    else if (user && group !== homeGroup) router.replace(home)
  }, [user, bootstrapping, segments, router])

  if (bootstrapping) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.amber} />
      </View>
    )
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(member)" />
      <Stack.Screen name="(admin)" />
    </Stack>
  )
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ToastProvider>
          <StatusBar style="light" />
          <RootLayoutNav />
        </ToastProvider>
      </AuthProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
})