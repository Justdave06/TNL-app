import { Ionicons } from '@expo/vector-icons'
import { Tabs } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import Header from '@/components/header'
import { colors } from '@/lib/theme'

/** Staff-only shell: overview, cashier scanner, points cards, physical cards. */
export default function AdminLayout() {
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
            title: 'Overview',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="stats-chart" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="scan"
          options={{
            title: 'Scanner',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="qr-code-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="vouchers"
          options={{
            title: 'Points cards',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="pricetags-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="physical-cards"
          options={{
            title: 'Physical cards',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="card-outline" color={color} size={size} />
            ),
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
  tabLabel: { fontSize: 10, fontWeight: '600' },
})
