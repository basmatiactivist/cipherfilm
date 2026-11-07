import { useState } from "react";
import { Keyboard, Linking } from "react-native";
import { router } from "expo-router";
import { Button } from "react-native-paper";
import { Column, Field, Lead, Problem, Screen, Title } from "../ui";
import { chooseServer, session } from "../session";
import { useAction } from "../useAction";
import { PRIVACY_URL } from "../store";

export default function ServerScreen() {
  const [address, setAddress] = useState(session().server.replace(/^https:\/\//, ""));
  const { busy, error, run } = useAction();
  const go = () => run(async () => {
    Keyboard.dismiss(); await chooseServer(address); router.replace("/signin"); });
  return (
    <Screen form>
      <Column>
        <Title>Connect to your Cipherfilm</Title>
        <Lead>The address of Cipherfilm in your browser.</Lead>
        <Problem>{error}</Problem>
        <Field label="Address" value={address} onChangeText={setAddress} placeholder="photos.example.com" autoCapitalize="none" keyboardType="url" textContentType="URL" returnKeyType="go" onSubmitEditing={go} />
        <Button mode="contained" onPress={go} loading={busy} disabled={busy || !address.trim()} contentStyle={{ height: 48 }}>Connect</Button>
        <Button mode="text" onPress={() => Linking.openURL(PRIVACY_URL)} style={{ marginTop: 8 }}>Privacy policy</Button>
      </Column>
    </Screen>
  );
}
