import { Stack } from 'expo-router'
import { View } from 'react-native'
import { colors } from '@/lib/theme'

export default function AuthLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  )
}