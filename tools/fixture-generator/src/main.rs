use std::io::Cursor;

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use serde::Serialize;
use stingle_crypto::{album, file, keys, mnemonic, pwhash, sodium};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileFixture {
    plaintext_base64: String,
    blob_base64: String,
    outer_header_base64_url: String,
    file_id_base64_url: String,
    filename: String,
    file_type: u8,
    video_duration: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumFixture {
    name: String,
    public_key_base64: String,
    private_key_base64: String,
    encrypted_private_key_base64: String,
    metadata_base64: String,
    file: FileFixture,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParamsFixture {
    json: String,
    encrypted_base64: String,
    server_public_key_base64: String,
    server_private_key_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    source: &'static str,
    password: &'static str,
    account_salt_hex: String,
    login_hash_hex: String,
    user_public_key_base64: String,
    user_private_key_base64: String,
    key_bundle_base64: String,
    mnemonic: String,
    gallery_file: FileFixture,
    album: AlbumFixture,
    params: ParamsFixture,
}

fn deterministic_plaintext(length: usize, seed: u8) -> Vec<u8> {
    (0..length)
        .map(|index| seed.wrapping_add((index.wrapping_mul(31) % 251) as u8))
        .collect()
}

fn upper_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn make_file(
    plaintext: Vec<u8>,
    filename: &str,
    file_type: u8,
    duration: u32,
    recipient_pk: &[u8],
) -> Result<FileFixture, Box<dyn std::error::Error>> {
    let file_id = file::new_file_id()?;
    let (blob, _) = file::encrypt_bytes(
        &plaintext,
        filename,
        file_type,
        file_id.clone(),
        duration,
        recipient_pk,
    )?;
    let outer_header = file::extract_header_bytes(&mut Cursor::new(blob.as_slice()))?;
    Ok(FileFixture {
        plaintext_base64: B64.encode(plaintext),
        blob_base64: B64.encode(blob),
        outer_header_base64_url: B64URL.encode(outer_header),
        file_id_base64_url: B64URL.encode(file_id),
        filename: filename.to_owned(),
        file_type,
        video_duration: duration,
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    stingle_crypto::init()?;
    let password = "phase0-correct-horse-battery-staple";
    let user = keys::KeyPair::generate()?;
    let bundle = keys::KeyBundle::create(password, &user)?;
    let account_salt: Vec<u8> = (0u8..16).collect();
    let login_hash = pwhash::password_hash_for_storage(password, &account_salt)?;
    let recovery_phrase = mnemonic::entropy_to_mnemonic(&user.secret_key)?;

    let gallery_file = make_file(
        deterministic_plaintext(4_097, 17),
        "phase-0-gallery.mp4",
        3,
        137,
        &user.public_key,
    )?;

    let album_name = "Phase 0 shared album";
    let (album_keys, album_data) =
        album::generate_encrypted_album_data(&user.public_key, album_name)?;
    let album_file = make_file(
        deterministic_plaintext(8_191, 89),
        "phase-0-album.mov",
        3,
        241,
        &album_keys.public_key,
    )?;

    let server = keys::KeyPair::generate()?;
    let params_json = r#"{"albumId":"fixture-album","count":"2","isMoving":"0"}"#;
    let encrypted_params = keys::encrypt_params_for_server(
        params_json.as_bytes(),
        &server.public_key,
        &user.secret_key,
    )?;

    let fixture = Fixture {
        source: "stingle-desktop/crates/stingle-crypto",
        password,
        account_salt_hex: upper_hex(&account_salt),
        login_hash_hex: login_hash,
        user_public_key_base64: B64.encode(&user.public_key),
        user_private_key_base64: B64.encode(&user.secret_key),
        key_bundle_base64: bundle.to_base64(),
        mnemonic: recovery_phrase,
        gallery_file,
        album: AlbumFixture {
            name: album_name.to_owned(),
            public_key_base64: album_data.public_key,
            private_key_base64: B64.encode(&album_keys.secret_key),
            encrypted_private_key_base64: album_data.encrypted_private_key,
            metadata_base64: album_data.metadata,
            file: album_file,
        },
        params: ParamsFixture {
            json: params_json.to_owned(),
            encrypted_base64: encrypted_params,
            server_public_key_base64: B64.encode(&server.public_key),
            server_private_key_base64: B64.encode(&server.secret_key),
        },
    };

    println!("{}", serde_json::to_string_pretty(&fixture)?);
    sodium::init()?;
    Ok(())
}
