import { useEffect, useState } from "react";
import { Text, View, StyleSheet } from "react-native";

function getPaliaTime() {
  const now = new Date();

  const secondsIntoHour =
    now.getMinutes() * 60 +
    now.getSeconds();

  const paliaMinutesTotal = (secondsIntoHour / 3600) * 1440;

  const hour = Math.floor(paliaMinutesTotal / 60);
  const minute = Math.floor(paliaMinutesTotal % 60);

  return {
    formatted: `${hour.toString().padStart(2, "0")}:${minute
      .toString()
      .padStart(2, "0")}`,
  };
}

export default function App() {
  const [paliaTime, setPaliaTime] = useState(getPaliaTime());

  useEffect(() => {
    const interval = setInterval(() => {
      setPaliaTime(getPaliaTime());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>PALIA TIME</Text>
      <Text style={styles.time}>{paliaTime.formatted}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0e1a14",
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    color: "#8bcf9f",
    fontSize: 16,
    marginBottom: 8,
    letterSpacing: 2,
  },
  time: {
    color: "#ffffff",
    fontSize: 64,
    fontWeight: "bold",
  },
});
