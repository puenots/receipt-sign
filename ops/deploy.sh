#!/bin/bash
# 領収書 API(Lambda+S3)を作成/更新する(何度実行してもよい)。
# パスワード等は repo の外 SECRETS に置く。無ければ初回に作る。
set -euo pipefail
cd "$(dirname "$0")/.."
ACC=985807745746
R=ap-northeast-1
FN=receipt-sign-api
ROLE=receipt-sign-api-role
DATA=stoneup-receipt-data
PDF=stoneup-receipt-pdf
SITE=https://receipt.djue.me
SECRETS=${SECRETS:-$HOME/Documents/djue/receipt-sign-20261026/secrets.txt}

# --- 秘密情報 ---
if [ ! -f "$SECRETS" ]; then
  PW=$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')
  KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
  HASH=$(node --input-type=module -e "import {hashPassword} from './api/src/core.js'; console.log(hashPassword(process.argv[1]))" "$PW")
  umask 077
  printf 'ADMIN_PASSWORD=%s\nSESSION_KEY=%s\nADMIN_PASS_HASH=%s\n' "$PW" "$KEY" "$HASH" > "$SECRETS"
fi
SESSION_KEY=$(grep '^SESSION_KEY=' "$SECRETS" | cut -d= -f2-)
ADMIN_PASS_HASH=$(grep '^ADMIN_PASS_HASH=' "$SECRETS" | cut -d= -f2-)

block_public() {
  aws s3api put-public-access-block --bucket "$1" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
}

# --- データ用バケット(名簿・領収書の状態・経理 ZIP)---
if ! aws s3api head-bucket --bucket $DATA 2>/dev/null; then
  aws s3api create-bucket --bucket $DATA --region $R --create-bucket-configuration LocationConstraint=$R >/dev/null
fi
block_public $DATA
aws s3api put-bucket-versioning --bucket $DATA --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket $DATA --lifecycle-configuration '{"Rules":[{"ID":"exports-7d","Filter":{"Prefix":"exports/"},"Status":"Enabled","Expiration":{"Days":7},"NoncurrentVersionExpiration":{"NoncurrentDays":7}}]}'

# --- 証拠用バケット(PDF・画像)。Object Lock GOVERNANCE 7 年=上書き・削除できない ---
if ! aws s3api head-bucket --bucket $PDF 2>/dev/null; then
  aws s3api create-bucket --bucket $PDF --region $R --create-bucket-configuration LocationConstraint=$R --object-lock-enabled-for-bucket >/dev/null
fi
block_public $PDF
aws s3api put-object-lock-configuration --bucket $PDF --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Years":7}}}'

# --- IAM ロール(PDF バケットは読み書きのみ・削除権限なし)---
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10
fi
aws iam put-role-policy --role-name $ROLE --policy-name s3 --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
 {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],\"Resource\":[\"arn:aws:s3:::$DATA/*\",\"arn:aws:s3:::$PDF/*\"]},
 {\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::$DATA\"}]}"

# --- Lambda ---
rm -rf .build && mkdir .build && cp -R api/src api/package.json api/package-lock.json .build/
(cd .build && npm ci --omit=dev --silent && zip -qr ../.build.zip .)
ENVV="Variables={DATA_BUCKET=$DATA,PDF_BUCKET=$PDF,SITE_URL=$SITE,SESSION_KEY=$SESSION_KEY,ADMIN_PASS_HASH=$ADMIN_PASS_HASH}"
if aws lambda get-function --region $R --function-name $FN >/dev/null 2>&1; then
  aws lambda update-function-code --region $R --function-name $FN --zip-file fileb://.build.zip >/dev/null
  aws lambda wait function-updated --region $R --function-name $FN
  aws lambda update-function-configuration --region $R --function-name $FN --environment "$ENVV" >/dev/null
else
  aws lambda create-function --region $R --function-name $FN --runtime nodejs22.x --handler src/index.handler \
    --role arn:aws:iam::$ACC:role/$ROLE --zip-file fileb://.build.zip --timeout 30 --memory-size 512 \
    --environment "$ENVV" >/dev/null
fi
aws lambda wait function-updated --region $R --function-name $FN
rm -rf .build .build.zip

# --- 公開 URL(CORS はコード側で receipt.djue.me と localhost に限定)---
if ! aws lambda get-function-url-config --region $R --function-name $FN >/dev/null 2>&1; then
  aws lambda create-function-url-config --region $R --function-name $FN --auth-type NONE >/dev/null
  aws lambda add-permission --region $R --function-name $FN --statement-id url-public --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --region $R --function-name $FN --statement-id url-invoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
fi
aws lambda get-function-url-config --region $R --function-name $FN --query FunctionUrl --output text
