import * as React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from './theme'

export type ToastVariant = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

interface ToastContextValue {
  push: (message: string, variant?: ToastVariant, duration?: number) => number
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

let nextId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets()
  const [toasts, setToasts] = React.useState<Toast[]>([])

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = React.useCallback(
    (message: string, variant: ToastVariant = 'info', duration = 5000): number => {
      const id = ++nextId
      setToasts((current) => [...current, { id, message, variant }])
      setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={React.useMemo(() => ({ push }), [push])}>
      {children}
      <View pointerEvents="none" style={[styles.host, { top: insets.top + 12 }]}>
        {toasts.map((toast) => (
          <View
            key={toast.id}
            style={[
              styles.toast,
              toast.variant === 'success' && styles.success,
              toast.variant === 'error' && styles.error,
            ]}
          >
            <Text style={styles.text}>{toast.message}</Text>
          </View>
        ))}
      </View>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within a ToastProvider')
  return context
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 100,
    gap: 8,
  },
  toast: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  success: {
    borderColor: 'rgba(52, 211, 153, 0.4)',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  error: {
    borderColor: 'rgba(239, 68, 68, 0.4)',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  text: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
})