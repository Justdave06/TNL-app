import { Ionicons } from '@expo/vector-icons'
import { Tabs } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import Header from '@/components/header'
import { colors } from '@/lib/theme'

/** Customer-only shell: rewards dashboard and digital card. */
export default function MemberLayout() {
  return (
    <View style={styles.wrap}>
      <Header />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.amber,
          tabBarInactiveTintColor: colors.textFaint,
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.tabLabel,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => <Ionicons name="home" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="card"
          options={{
            title: 'My Card',
            tabBarIcon: ({ color, size }) => <Ionicons name="card" color={color} size={size} />,
          }}
        />
      </Tabs>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    height: 80,
    paddingTop: 8,
  },
  tabLabel: { fontSize: 11, fontWeight: '600' },
})
