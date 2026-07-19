import React, {useEffect, useState} from 'react';
import {View, Text, Button, Alert} from 'react-native';
import * as Linking from 'expo-linking';
import * as LocalAuthentication from 'expo-local-authentication';
import {parseSEP0007Params} from '../utils/sep0007';
import {useRouter} from 'expo-router';

// NOTE: This is a scaffold handler. Integrate with wallet SDK and auth providers.
export default function SEP0007Screen() {
  const url = Linking.useURL();
  const [params, setParams] = useState<any>(null);
  const router = useRouter();

  useEffect(() => {
    setParams(parseSEP0007Params(url));
  }, [url]);

  if (!params || !params.destination) {
    return (
      <View style={{padding:16}}>
        <Text>Invalid payment request.</Text>
      </View>
    );
  }

  return (
    <View style={{padding:16}}>
      <Text style={{fontSize:18,fontWeight:'600'}}>Payment Request</Text>
      <Text>To: {params.destination}</Text>
      <Text>Amount: {params.amount ?? '—' } XLM</Text>
      {params.memo && <Text>Memo: {params.memo}</Text>}
      {params.message && <Text>Message: {params.message}</Text>}

      <Button
        title="Confirm & Pay"
        onPress={async () => {
          const authed = await LocalAuthentication.authenticateAsync();
          if (!authed.success) {
            Alert.alert('Authentication failed');
            return;
          }
          // TODO: integrate with wallet SDK: build, sign, submit
          // Placeholder: navigate to success page with fake tx
          const transactionHash = 'stubbed_tx_hash';
          if (params.callback) {
            const callbackUrl = `${params.callback}?txHash=${transactionHash}`;
            try { await Linking.openURL(callbackUrl); } catch {}
          }
          router.replace(`/donate/success?txHash=${transactionHash}`);
        }}
      />
    </View>
  );
}
